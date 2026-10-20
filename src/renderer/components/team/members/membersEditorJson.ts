import { CUSTOM_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import {
  createMemberDraft,
  getMemberDraftRole,
  getWorkflowForExport,
} from './membersEditorUtils';

import type { MemberDraft } from './membersEditorTypes';
import type { EffortLevel } from '@shared/types';

export function membersToJsonText(drafts: MemberDraft[]): string {
  const arr = drafts
    .filter((d) => d.name.trim())
    .map((d) => {
      const role = getMemberDraftRole(d);
      const obj: Record<string, unknown> = { name: d.name.trim() };
      if (role) obj.role = role;
      const workflow = getWorkflowForExport(d);
      if (workflow) obj.workflow = workflow;
      if (d.isolation === 'worktree') obj.isolation = 'worktree';
      if (d.providerId) obj.providerId = d.providerId;
      if (d.model?.trim()) obj.model = d.model.trim();
      if (d.effort) obj.effort = d.effort;
      if (d.mcpPolicy) obj.mcpPolicy = d.mcpPolicy;
      return obj;
    });
  return JSON.stringify(arr, null, 2);
}

export function parseJsonToDrafts(text: string): MemberDraft[] {
  const arr: unknown = JSON.parse(text);
  if (!Array.isArray(arr)) return [];
  return (arr as Record<string, unknown>[]).map((item) => {
    const name = typeof item.name === 'string' ? item.name : '';
    const role = typeof item.role === 'string' ? item.role.trim() : '';
    const workflow = typeof item.workflow === 'string' ? item.workflow.trim() : '';
    const isolation = item.isolation === 'worktree' ? 'worktree' : undefined;
    const providerId = normalizeOptionalTeamProviderId(item.providerId);
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    const effort: EffortLevel | undefined = isTeamEffortLevel(item.effort) ? item.effort : undefined;
    const mcpPolicy = normalizeTeamMemberMcpPolicy(item.mcpPolicy);
    const presetRoles: readonly string[] = PRESET_ROLES;
    const isPreset = presetRoles.includes(role);
    return createMemberDraft({
      name,
      roleSelection: role ? (isPreset ? role : CUSTOM_ROLE) : '',
      customRole: role && !isPreset ? role : '',
      workflow: workflow || undefined,
      isolation,
      providerId,
      model,
      effort,
      mcpPolicy,
    });
  });
}
