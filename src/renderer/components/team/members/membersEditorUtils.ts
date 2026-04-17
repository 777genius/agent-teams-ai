import { CUSTOM_ROLE, NO_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import { normalizeCreateLaunchProviderForUi } from '@renderer/utils/geminiUiFreeze';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { normalizeTeamModelForUi } from '@renderer/utils/teamModelAvailability';
import { normalizeTeamModelForUi as normalizeCatalogTeamModelForUi } from '@renderer/utils/teamModelCatalog';
import { extractProviderScopedBaseModel } from '@renderer/utils/teamModelContext';
import { isLeadMember } from '@shared/utils/leadDetection';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { MemberDraft } from './membersEditorTypes';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { EffortLevel, TeamProviderId, TeamProvisioningMemberInput } from '@shared/types';

function isValidMemberName(name: string): boolean {
  if (name.length < 1 || name.length > 128) return false;
  if (!/^[a-zA-Z0-9]/.test(name)) return false;
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

export function validateMemberNameInline(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (!isValidMemberName(trimmed)) {
    return 'Start with alphanumeric, use only [a-zA-Z0-9._-], max 128 chars';
  }
  return null;
}

function newDraftId(): string {
  // eslint-disable-next-line sonarjs/pseudo-random -- Used for generating unique UI keys, not security
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMemberDraft(initial?: Partial<MemberDraft>): MemberDraft {
  const providerId = initial?.providerId;
  const normalizedModel = extractProviderScopedBaseModel(initial?.model ?? '', providerId) ?? '';
  return {
    id: initial?.id ?? newDraftId(),
    name: initial?.name ?? '',
    roleSelection: initial?.roleSelection ?? '',
    customRole: initial?.customRole ?? '',
    workflow: initial?.workflow,
    providerId,
    model: normalizeCatalogTeamModelForUi(providerId, normalizedModel),
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
        roleSelection: role ? (isPreset ? role : CUSTOM_ROLE) : '',
        customRole: role && !isPreset ? role : '',
        workflow: member.workflow,
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
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return undefined;
}

interface ExistingMemberColorInput {
  name: string;
  color?: string;
  removedAt?: number | string | null;
}

export function buildMemberDraftColorMap(
  members: readonly Pick<MemberDraft, 'name'>[],
  existingMembers?: readonly ExistingMemberColorInput[]
): Map<string, string> {
  const draftEntries = members
    .map((member) => member.name.trim())
    .filter(Boolean)
    .map((name) => ({ name }));

  // When existing members are provided, include them first so their colors
  // are reserved and new drafts receive the next available palette entries.
  const allEntries = existingMembers ? [...existingMembers, ...draftEntries] : draftEntries;

  const fullMap = buildMemberColorMap(allEntries);

  // Return only draft entries so callers don't see existing-member keys
  // they didn't ask for (keeps the API surface unchanged).
  if (!existingMembers) return fullMap;

  const draftMap = new Map<string, string>();
  for (const entry of draftEntries) {
    const color = fullMap.get(entry.name);
    if (color) draftMap.set(entry.name, color);
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
      color: colorMap.get(m.name.trim()) ?? undefined,
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
      const providerId = normalizeOptionalTeamProviderId(member.providerId);
      if (providerId) {
        result.providerId = providerId;
      }
      const model = member.model?.trim();
      if (model) {
        result.model = normalizeTeamModelForUi(providerId, model);
      }
      const effort = normalizeDraftEffort(member.effort);
      if (effort) {
        result.effort = effort;
      }
      return result;
    })
    .filter((member): member is NonNullable<typeof member> => member !== null);
}
