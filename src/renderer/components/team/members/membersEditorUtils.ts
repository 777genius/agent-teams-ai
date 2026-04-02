import { CUSTOM_ROLE, NO_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';

import type { MemberDraft } from './membersEditorTypes';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { EffortLevel, TeamProvisioningMemberInput, TeamProviderId } from '@shared/types';

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
  return {
    id: initial?.id ?? newDraftId(),
    name: initial?.name ?? '',
    roleSelection: initial?.roleSelection ?? '',
    customRole: initial?.customRole ?? '',
    workflow: initial?.workflow,
    providerId: initial?.providerId,
    model: initial?.model ?? '',
    effort: initial?.effort,
  };
}

export function createMemberDraftsFromInputs(
  members: readonly {
    name: string;
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
        providerId:
          member.providerId === 'codex' || member.providerId === 'gemini'
            ? member.providerId
            : 'anthropic',
        model: member.model ?? '',
        effort: normalizeDraftEffort(member.effort),
      });
    });
}

export function clearMemberModelOverrides(member: MemberDraft): MemberDraft {
  return {
    ...member,
    providerId: undefined,
    model: '',
    effort: undefined,
  };
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
      const name = member.name.trim();
      if (!name) {
        return null;
      }

      const role = getMemberDraftRole(member);
      const result: TeamProvisioningMemberInput = { name, role };
      const workflow = getWorkflowForExport(member);
      if (workflow) result.workflow = workflow;
      const providerId: TeamProviderId =
        member.providerId === 'codex' || member.providerId === 'gemini'
          ? member.providerId
          : 'anthropic';
      if (providerId !== 'anthropic') {
        result.providerId = providerId;
      }
      const model = member.model?.trim();
      if (model) {
        result.model = model;
      }
      const effort = normalizeDraftEffort(member.effort);
      if (effort) {
        result.effort = effort;
      }
      return result;
    })
    .filter((member): member is NonNullable<typeof member> => member !== null);
}
