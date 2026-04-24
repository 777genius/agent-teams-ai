import { CUSTOM_ROLE, NO_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import { normalizeCreateLaunchProviderForUi } from '@renderer/utils/geminiUiFreeze';
import { normalizeExplicitTeamModelForUi } from '@renderer/utils/teamModelAvailability';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
import { validateTeamMemberNameFormat } from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { MemberDraft } from './membersEditorTypes';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { EffortLevel, TeamProviderId, TeamProvisioningMemberInput } from '@shared/types';

export function validateMemberNameInline(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return validateTeamMemberNameFormat(trimmed);
}

function newDraftId(): string {
  // eslint-disable-next-line sonarjs/pseudo-random -- Used for generating unique UI keys, not security
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMemberDraft(initial?: Partial<MemberDraft>): MemberDraft {
  const providerId = initial?.providerId;
  return {
    id: initial?.id ?? newDraftId(),
    name: initial?.name ?? '',
    originalName: initial?.originalName,
    roleSelection: initial?.roleSelection ?? '',
    customRole: initial?.customRole ?? '',
    workflow: initial?.workflow,
    isolation: initial?.isolation === 'worktree' ? 'worktree' : undefined,
    providerId,
    model: normalizeExplicitTeamModelForUi(providerId, initial?.model ?? ''),
    effort: initial?.effort,
    removedAt: initial?.removedAt,
  };
}

export function createMemberDraftsFromInputs(
  members: readonly {
    name: string;
    agentType?: string;
    role?: string;
    workflow?: string;
    providerId?: TeamProviderId;
    model?: string;
    effort?: EffortLevel;
    isolation?: 'worktree';
    removedAt?: number | string | null;
  }[]
): MemberDraft[] {
  return members
    .filter((member) => !member.removedAt)
    .map((member) => {
      const role = typeof member.role === 'string' ? member.role.trim() : '';
      const presetRoles: readonly string[] = PRESET_ROLES;
      const isPreset = presetRoles.includes(role);
      return createMemberDraft({
        name: member.name,
        originalName: member.name,
        roleSelection: role ? (isPreset ? role : CUSTOM_ROLE) : '',
        customRole: role && !isPreset ? role : '',
        workflow: member.workflow,
        isolation: member.isolation === 'worktree' ? 'worktree' : undefined,
        providerId: normalizeOptionalTeamProviderId(member.providerId),
        model: member.model ?? '',
        effort: normalizeDraftEffort(member.effort),
        removedAt: member.removedAt,
      });
    });
}

export function filterEditableMemberInputs<T extends { name?: unknown; agentType?: unknown }>(
  members: readonly T[]
): T[] {
  return members.filter((member) => !isLeadMember(member));
}

export function clearMemberModelOverrides(member: MemberDraft): MemberDraft {
  return {
    ...member,
    providerId: undefined,
    model: '',
    effort: undefined,
  };
}

export function normalizeProviderForMode(
  providerId: TeamProviderId | undefined,
  multimodelEnabled: boolean
): TeamProviderId {
  return normalizeCreateLaunchProviderForUi(providerId, multimodelEnabled);
}

export function normalizeLeadProviderForMode(
  providerId: TeamProviderId | undefined,
  multimodelEnabled: boolean
): TeamProviderId {
  const normalizedProviderId = normalizeProviderForMode(providerId, multimodelEnabled);
  return normalizedProviderId === 'opencode' ? 'anthropic' : normalizedProviderId;
}

export function normalizeMemberDraftForProviderMode(
  member: MemberDraft,
  multimodelEnabled: boolean
): MemberDraft {
  const normalizedProviderId =
    member.providerId == null
      ? undefined
      : normalizeCreateLaunchProviderForUi(member.providerId, multimodelEnabled);

  if (normalizedProviderId === member.providerId) {
    return member;
  }

  if (
    member.providerId === 'codex' ||
    member.providerId === 'gemini' ||
    normalizedProviderId !== member.providerId
  ) {
    return {
      ...member,
      providerId: normalizedProviderId,
      model: '',
    };
  }
  return member;
}

function normalizeDraftEffort(value: string | undefined): EffortLevel | undefined {
  return isTeamEffortLevel(value) ? value : undefined;
}

interface ExistingMemberColorInput {
  name: string;
  color?: string;
  removedAt?: number | string | null;
}

function getMemberDraftColorSeedKey(member: Pick<MemberDraft, 'id' | 'originalName'>): string {
  const originalName = member.originalName?.trim();
  return originalName || `draft:${member.id}`;
}

export function buildMemberDraftColorMap(
  members: readonly Pick<MemberDraft, 'id' | 'name' | 'originalName'>[],
  existingMembers?: readonly ExistingMemberColorInput[],
  existingColorMap?: ReadonlyMap<string, string>
): Map<string, string> {
  const normalizedExistingColorMap = new Map<string, string>(
    Array.from(existingColorMap?.entries() ?? []).map(([name, color]) => [
      name.trim().toLowerCase(),
      color,
    ])
  );

  const existingSeedEntries = (existingMembers ?? [])
    .map((member) => ({
      ...member,
      name: member.name.trim(),
      color:
        normalizedExistingColorMap.get(member.name.trim().toLowerCase()) ??
        member.color?.trim() ??
        undefined,
    }))
    .filter((member) => member.name);
  const existingNames = new Set(existingSeedEntries.map((member) => member.name.toLowerCase()));
  const uniqueNewDraftEntries = members
    .filter((member) => {
      if (member.originalName?.trim()) {
        return false;
      }
      const currentName = member.name.trim();
      return !currentName || !existingNames.has(currentName.toLowerCase());
    })
    .map((member) => ({ name: getMemberDraftColorSeedKey(member) }));

  const fullMap = buildTeamMemberColorMap([...existingSeedEntries, ...uniqueNewDraftEntries], {
    preferProvidedColors: true,
  });
  const fullColorByName = new Map(
    Array.from(fullMap.entries()).map(([name, color]) => [name.toLowerCase(), color] as const)
  );

  const draftMap = new Map<string, string>();
  for (const member of members) {
    const originalName = member.originalName?.trim();
    const currentName = member.name.trim();
    const colorSeedKey = originalName
      ? originalName
      : currentName && existingNames.has(currentName.toLowerCase())
        ? currentName
        : getMemberDraftColorSeedKey(member);
    const color = fullColorByName.get(colorSeedKey.toLowerCase());
    if (color) draftMap.set(member.id, color);
  }
  return draftMap;
}

/** Resolves a MemberDraft's role selection to a display string. */
export function getMemberDraftRole(member: MemberDraft): string | undefined {
  return member.roleSelection === CUSTOM_ROLE
    ? member.customRole.trim() || undefined
    : member.roleSelection === NO_ROLE
      ? undefined
      : member.roleSelection.trim() || undefined;
}

/** Builds MentionSuggestion[] from MemberDraft[], reusing color map and role resolution. */
export function buildMemberDraftSuggestions(
  members: MemberDraft[],
  colorMap: Map<string, string>
): MentionSuggestion[] {
  return members
    .filter((m) => m.name.trim())
    .map((m) => ({
      id: m.id,
      name: m.name.trim(),
      subtitle: getMemberDraftRole(m),
      color: colorMap.get(m.id) ?? undefined,
    }));
}

/** Resolves workflow for export (JSON or API): serializes chips when present. */
export function getWorkflowForExport(member: MemberDraft): string | undefined {
  const workflowRaw = member.workflow?.trim();
  if (!workflowRaw) return undefined;
  const chips = member.workflowChips ?? [];
  return chips.length > 0 ? serializeChipsWithText(workflowRaw, chips) : workflowRaw;
}

export function buildMembersFromDrafts(members: MemberDraft[]): TeamProvisioningMemberInput[] {
  return members
    .map((member) => {
      if (member.removedAt) {
        return null;
      }
      const name = member.name.trim();
      if (!name) {
        return null;
      }

      const role = getMemberDraftRole(member);
      const result: TeamProvisioningMemberInput = { name, role };
      const workflow = getWorkflowForExport(member);
      if (workflow) result.workflow = workflow;
      if (member.isolation === 'worktree') result.isolation = 'worktree';
      const providerId = normalizeOptionalTeamProviderId(member.providerId);
      if (providerId) {
        result.providerId = providerId;
      }
      const model = member.model?.trim();
      if (model) {
        result.model = normalizeExplicitTeamModelForUi(providerId, model);
      }
      const effort = normalizeDraftEffort(member.effort);
      if (effort) {
        result.effort = effort;
      }
      return result;
    })
    .filter((member): member is NonNullable<typeof member> => member !== null);
}
