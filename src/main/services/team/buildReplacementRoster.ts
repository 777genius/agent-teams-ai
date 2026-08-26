import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { parseNumericSuffixName, validateTeamMemberNameFormat } from '@shared/utils/teamMemberName';
import { normalizeTeamMemberRuntimeSelectionProvenance } from '@shared/utils/teamMemberRuntimeSelectionProvenance';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { ReplaceMembersRequest, TeamMember } from '@shared/types';

export function buildReplacementRoster(
  existing: readonly TeamMember[],
  requested: ReplaceMembersRequest['members'],
  applyColors: (members: readonly TeamMember[]) => TeamMember[],
  joinedAt = Date.now()
): TeamMember[] {
  const existingLead = existing.find(isLeadMember) ?? null;
  const existingByName = new Map(existing.map((member) => [member.name.toLowerCase(), member]));
  const nextByName = new Set<string>();
  const nextActive = applyColors(
    requested.map((member) => {
      const name = member.name.trim();
      if (!name) throw new Error('Member name cannot be empty');
      const formatError = validateTeamMemberNameFormat(name);
      if (formatError) throw new Error(`Member name "${name}" is invalid: ${formatError}`);
      if (name.toLowerCase() === 'user') throw new Error('Member name "user" is reserved');
      if (name.toLowerCase() === 'team-lead') {
        throw new Error('Member name "team-lead" is reserved');
      }
      if (nextByName.has(name.toLowerCase())) throw new Error(`Member "${name}" already exists`);
      const suffixInfo = parseNumericSuffixName(name);
      if (suffixInfo && suffixInfo.suffix >= 2) {
        throw new Error(
          `Member name "${name}" is not allowed (reserved for runtime-managed numeric suffixes). Use "${suffixInfo.base}" instead.`
        );
      }
      nextByName.add(name.toLowerCase());
      const prev = existingByName.get(name.toLowerCase());
      const sameActiveMember = Boolean(prev && prev.removedAt == null);
      const providerId = normalizeOptionalTeamProviderId(member.providerId);
      return {
        ...(prev ?? {}),
        name,
        role: member.role?.trim() || undefined,
        workflow: member.workflow?.trim() || undefined,
        isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId,
        providerBackendId: providerId
          ? migrateProviderBackendId(providerId, member.providerBackendId, 'explicit-selection')
          : member.providerBackendId,
        model: member.model?.trim() || undefined,
        effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
        runtimeSelectionProvenance: normalizeTeamMemberRuntimeSelectionProvenance(
          member.runtimeSelectionProvenance
        ),
        fastMode:
          member.fastMode === 'inherit' || member.fastMode === 'on' || member.fastMode === 'off'
            ? member.fastMode
            : undefined,
        mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
        agentType: prev?.agentType ?? 'general-purpose',
        agentId: sameActiveMember ? prev?.agentId : undefined,
        color: prev?.color,
        joinedAt: prev?.joinedAt ?? joinedAt,
        removedAt: undefined,
      };
    })
  );
  const removed = existing
    .filter((member) => {
      const name = member.name.trim();
      return name && !isLeadMember(member) && !nextByName.has(name.toLowerCase());
    })
    .map((member) => ({ ...member, removedAt: member.removedAt ?? joinedAt }));
  const output = [...nextActive, ...removed];
  if (existingLead && !output.some((member) => member.name === existingLead.name)) {
    output.unshift({ ...existingLead, removedAt: undefined });
  }
  return output;
}
