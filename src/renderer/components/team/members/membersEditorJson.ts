import { CUSTOM_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { resolveMemberRuntimeSelectionProvenance } from '@shared/utils/teamMemberRuntimeSelectionProvenance';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { createMemberDraft, getMemberDraftRole, getWorkflowForExport } from './membersEditorUtils';

import type { MemberDraft } from './membersEditorTypes';
import type { EffortLevel } from '@shared/types';

export function membersToJsonText(drafts: MemberDraft[]): string {
  const members = drafts
    .filter((draft) => draft.name.trim())
    .map((draft) => {
      const role = getMemberDraftRole(draft);
      const member: Record<string, unknown> = { name: draft.name.trim() };
      if (role) member.role = role;
      const workflow = getWorkflowForExport(draft);
      if (workflow) member.workflow = workflow;
      if (draft.isolation === 'worktree') member.isolation = 'worktree';
      if (draft.providerId) member.providerId = draft.providerId;
      if (draft.providerBackendId) member.providerBackendId = draft.providerBackendId;
      if (draft.model?.trim()) member.model = draft.model.trim();
      if (draft.effort) member.effort = draft.effort;
      member.runtimeSelectionProvenance = resolveMemberRuntimeSelectionProvenance(draft);
      if (draft.mcpPolicy) member.mcpPolicy = draft.mcpPolicy;
      return member;
    });
  return JSON.stringify(members, null, 2);
}

export function parseJsonToDrafts(text: string): MemberDraft[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) return [];
  return (parsed as Record<string, unknown>[]).map((item) => {
    const name = typeof item.name === 'string' ? item.name : '';
    const role = typeof item.role === 'string' ? item.role.trim() : '';
    const workflow = typeof item.workflow === 'string' ? item.workflow.trim() : '';
    const providerId = normalizeOptionalTeamProviderId(item.providerId);
    const effort: EffortLevel | undefined = isTeamEffortLevel(item.effort)
      ? item.effort
      : undefined;
    const isPreset = (PRESET_ROLES as readonly string[]).includes(role);
    return createMemberDraft({
      name,
      roleSelection: role ? (isPreset ? role : CUSTOM_ROLE) : '',
      customRole: role && !isPreset ? role : '',
      workflow: workflow || undefined,
      isolation: item.isolation === 'worktree' ? 'worktree' : undefined,
      providerId,
      providerBackendId:
        typeof item.providerBackendId === 'string'
          ? (item.providerBackendId as MemberDraft['providerBackendId'])
          : undefined,
      model: typeof item.model === 'string' ? item.model.trim() : '',
      effort,
      runtimeSelectionProvenance: resolveMemberRuntimeSelectionProvenance({
        ...item,
        providerId,
      }),
      mcpPolicy: normalizeTeamMemberMcpPolicy(item.mcpPolicy),
    });
  });
}
