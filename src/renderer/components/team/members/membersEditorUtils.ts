import { CUSTOM_ROLE, NO_ROLE } from '@renderer/constants/teamRoles';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { serializeChipsWithText } from '@renderer/types/inlineChip';

import type { MemberDraft } from './membersEditorTypes';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { TeamProvisioningMemberInput } from '@shared/types';

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
  };
}

export function buildMemberDraftColorMap(
  members: ReadonlyArray<Pick<MemberDraft, 'name'>>
): Map<string, string> {
  return buildMemberColorMap(
    members
      .map((member) => member.name.trim())
      .filter(Boolean)
      .map((name) => ({ name }))
  );
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
      return result;
    })
    .filter((member): member is NonNullable<typeof member> => member !== null);
}
