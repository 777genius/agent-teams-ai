import type { ResolvedTeamMember, TeamCreateRequest } from '@shared/types';

/** What the Edit Team dialog shows, taken from the saved team definition. */
export interface DefinitionEditorInput {
  currentName: string;
  currentDescription: string;
  currentColor: string;
  /** The saved lead instructions of the definition (the next launch uses them). */
  currentLeadPrompt: string;
  currentMembers: ResolvedTeamMember[];
  leadMember: ResolvedTeamMember;
}

type SavedMember = TeamCreateRequest['members'][number];

/**
 * The editor works on resolved (runtime) members. A saved definition has no
 * runtime, so every member is shown as not running with its configured
 * settings: this is the definition, not a snapshot of one project's run.
 */
function toEditorMember(member: SavedMember): ResolvedTeamMember {
  const { name, role, workflow, isolation, providerId, providerBackendId, model, effort, fastMode } =
    member;
  return {
    name,
    status: 'unknown',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
    agentType: 'general-purpose',
    role,
    workflow,
    isolation,
    providerId,
    providerBackendId,
    model,
    effort,
    mcpPolicy: member.mcpPolicy,
    configuredRuntimeSettings: { providerId, providerBackendId, model, effort, fastMode },
  };
}

export function buildDefinitionEditorInput(
  saved: TeamCreateRequest,
  logicalTeamName: string
): DefinitionEditorInput {
  return {
    currentName: saved.displayName?.trim() || logicalTeamName,
    currentDescription: saved.description ?? '',
    currentColor: saved.color ?? '',
    currentLeadPrompt: saved.prompt ?? '',
    currentMembers: saved.members.map(toEditorMember),
    leadMember: {
      ...toEditorMember({
        name: 'team-lead',
        providerId: saved.providerId,
        providerBackendId: saved.providerBackendId,
        model: saved.model,
        effort: saved.effort,
        fastMode: saved.fastMode,
      }),
      agentType: 'team-lead',
    },
  };
}
